// „Woche vorschlagen“: the review of a week's timesheet draft (meetings, focus sessions, page
// edits), laid out by day. Rows are checked, edited and taken over in one go as drafts.

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarDays, CheckCircle2, FileText, Target, WandSparkles } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Badge, Button, Dialog, EmptyState, Input, Spinner, Switch, type Tone } from "../components/ui";
import { addDays, dateLocale, fmtDate, fmtMinutes, isoDay, isoWeek, parseDurationInput, time, weekdayShort } from "../lib/format";
import { NetzplanSelect, VorgangSelect } from "./wbs";
import { accepted, dayState, dayTotals, edit, gapSummary, initRows, nextRow, overlaps, rowProblem, selectable, setChecked, toggle, wbsKey, type ReviewRow } from "../lib/weekplan";
import type { ProjectTree, ProposalConfidence, ProposalSourceKind, TimeEntryRow, WeekProposal } from "../lib/types";
import { t as tr, useT, withLabel, type TKey } from "../lib/i18n";

const CONFIDENCE: Record<ProposalConfidence, { readonly label: string; tone: Tone }> = {
  high: withLabel({ tone: "success" as Tone }, "wp.conf.high"),
  medium: withLabel({ tone: "accent" as Tone }, "wp.conf.medium"),
  low: withLabel({ tone: "warning" as Tone }, "wp.conf.low"),
  none: withLabel({ tone: "danger" as Tone }, "wp.conf.none"),
};

const SOURCE: Record<ProposalSourceKind, { icon: typeof CalendarDays; label: TKey }> = {
  calendar: { icon: CalendarDays, label: "tabs.calendar" },
  focus: { icon: Target, label: "wp.src.focus" },
  page: { icon: FileText, label: "wp.src.page" },
};

const dayOf = (iso: string) => new Date(`${iso}T12:00:00`);
const weekdayOf = (iso: string) => weekdayShort(dayOf(iso));
const hours = (m: number) => `${fmtMinutes(m)} h`;

export function WeekProposalDialog({ week, entries, wbs, onClose }: { week: Date; entries: TimeEntryRow[]; wbs: ProjectTree[]; onClose: () => void }) {
  useT();
  const [data, setData] = useState<WeekProposal | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [restOfToday, setRestOfToday] = useState(false);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const s = useApp.getState;
  const today = isoDay(new Date());
  const thisWeek = today >= isoDay(week) && today <= isoDay(addDays(week, 6));

  useEffect(() => {
    let alive = true;
    setFailed(null);
    api
      .weekProposal(isoDay(week), restOfToday)
      .then((p) => {
        if (!alive) return;
        setData(p);
        setRows(initRows(p.proposals, fmtMinutes));
      })
      .catch((e) => alive && setFailed(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [week, restOfToday]);

  const totals = useMemo(() => (data ? dayTotals(data.days, rows) : []), [data, rows]);
  const clash = useMemo(() => overlaps(rows, entries), [rows, entries]);
  const chosen = rows.filter((r) => r.checked);
  const chosenMinutes = chosen.reduce((a, r) => a + r.minutes, 0);
  const open = gapSummary(totals, weekdayOf, fmtMinutes);

  const apply = async (list: ReviewRow[]) => {
    const items = accepted(list);
    if (!items.length || busy) return;
    setBusy(true);
    try {
      const out = await api.weekProposalApply(items);
      s().toast({
        tone: "success",
        title: tr("wp.created", { n: out.entry_ids.length }),
        detail: tr("wp.createdDetail"),
      });
      s().alerts(out.alerts);
      s().bumpEntries();
      onClose();
    } catch (e) {
      s().error(tr("wp.applyFailed"), e);
    } finally {
      setBusy(false);
    }
  };
  const applyAll = () => {
    const all = setChecked(rows, true);
    setRows(all);
    void apply(all);
  };

  const change = (id: string, patch: Parameters<typeof edit>[2]) => setRows((rs) => edit(rs, id, patch, parseDurationInput));
  const focusRow = (id: string | null) => id && listRef.current?.querySelector<HTMLElement>(`.wp-row[data-id="${CSS.escape(id)}"]`)?.focus();
  // Space toggles the focused row, arrows move, Enter takes the selection over.
  const onKey = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const row = target.classList.contains("wp-row") ? target.dataset.id ?? null : null;
    if (row && e.key === " ") {
      e.preventDefault();
      setRows((rs) => toggle(rs, row));
    } else if (row && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      focusRow(nextRow(rows.map((r) => r.id), row, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing && (row || target.tagName === "INPUT")) {
      e.preventDefault();
      void apply(rows);
    }
  };

  const days = data?.days.filter((d) => rows.some((r) => r.date === d.date)) ?? [];
  // Workdays without any proposal: one line below the days.
  const bare = totals.filter((t) => t.gap > 0 && !rows.some((r) => r.date === t.date));
  const range = `${fmtDate(week)} – ${fmtDate(addDays(week, 6))}`;

  return (
    <Dialog
      open
      onClose={onClose}
      title={tr("wp.title")}
      description={tr("wp.desc", { week: isoWeek(week), range })}
      width={960}
      footer={
        <>
          <span className="wp-foot-info small grow">
            {data && rows.length > 0 ? (
              <>
                <span className="num">
                  {tr("wp.chosen", { chosen: chosen.length, n: rows.length, hours: hours(chosenMinutes) })}
                </span>
                {clash.size > 0 && (
                  <span className="wp-foot-warn">
                    <AlertTriangle size={13} aria-hidden /> {tr("wp.clashes", { n: clash.size })}
                  </span>
                )}
              </>
            ) : null}
          </span>
          <Button variant="ghost" onClick={onClose}>
            {tr("common.cancel")}
          </Button>
          {rows.length > 0 && (
            <>
              <Button onClick={applyAll} disabled={busy || !rows.some((r) => rowProblem(r) == null)}>
                {tr("wp.applyAll")}
              </Button>
              <Button variant="primary" onClick={() => void apply(rows)} loading={busy} disabled={!chosen.length}>
                {chosen.length ? tr("wp.applyN", { n: chosen.length }) : tr("cf.apply")}
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="wp" onKeyDown={onKey}>
        {thisWeek && (
          <label className="wp-rest small row-gap">
            <Switch checked={restOfToday} onChange={setRestOfToday} label={tr("wp.restLabel")} /> {tr("wp.rest")}
          </label>
        )}
        {failed ? (
          <p className="error-note">{failed}</p>
        ) : !data ? (
          <div className="wp-loading">
            <Spinner size={18} />
          </div>
        ) : (
          <>
            <WeekStrip totals={totals} today={today} />
            {rows.length === 0 ? (
              <EmptyState icon={CheckCircle2} title={tr("wp.nothing")}>
                {open ? tr("wp.nothingOpen", { open }) : tr("wp.allBooked")}
              </EmptyState>
            ) : (
              <div className="wp-days" ref={listRef}>
                {days.map((d) => {
                  const t = totals.find((x) => x.date === d.date)!;
                  const list = rows.filter((r) => r.date === d.date);
                  const state = dayState(rows, d.date);
                  return (
                    <section key={d.date} className="wp-day" aria-label={dayOf(d.date).toLocaleDateString(dateLocale(), { weekday: "long" })}>
                      <header className="wp-day-head">
                        <input
                          type="checkbox"
                          className="check"
                          checked={state === "all"}
                          ref={(el) => {
                            if (el) el.indeterminate = state === "some";
                          }}
                          onChange={() => setRows((rs) => setChecked(rs, state !== "all", d.date))}
                          disabled={!list.some(selectable)}
                          aria-label={tr("wp.selectDay")}
                        />
                        <span className="wp-day-title">{dayOf(d.date).toLocaleDateString(dateLocale(), { weekday: "long", day: "numeric", month: "long" })}</span>
                        <span className="grow" />
                        <span className="wp-day-sum small num" title={tr("wp.daySum")}>
                          {hours(t.booked)} + {hours(t.selected)}
                          {t.target > 0 && <span className="faint"> / {hours(t.target)}</span>}
                        </span>
                        {t.gap > 0 ? (
                          <Badge tone="warning" title={t.capped ? tr("wp.capped", { hours: hours(t.capped) }) : undefined}>
                            {tr("wp.gap", { hours: hours(t.gap) })}
                          </Badge>
                        ) : t.target > 0 && d.started ? (
                          <Badge tone="success">{tr("wp.targetMet")}</Badge>
                        ) : null}
                      </header>
                      {list.map((r) => (
                        <Row key={r.id} r={r} wbs={wbs} clash={clash.has(r.id)} change={change} onToggle={() => setRows((rs) => toggle(rs, r.id))} />
                      ))}
                    </section>
                  );
                })}
                {bare.length > 0 && (
                  <div className="wp-bare small" role="note">
                    <AlertTriangle size={14} aria-hidden />
                    <span>
                      {tr("wp.bare", { days: bare.map((x) => `${weekdayOf(x.date)} ${dayOf(x.date).getDate()}. ${hours(x.gap)}`).join(" · ") })}
                    </span>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function Row({ r, wbs, clash, change, onToggle }: { r: ReviewRow; wbs: ProjectTree[]; clash: boolean; change: (id: string, patch: Parameters<typeof edit>[2]) => void; onToggle: () => void }) {
  useT();
  const src = SOURCE[r.proposal.kind];
  const Icon = src.icon;
  // A WBS chosen by hand is remembered for the page or the meeting series.
  const chosen = r.netzplanId != null && wbsKey(r.netzplanId, r.vorgang) !== wbsKey(r.proposal.wbs?.netzplan_id ?? null, r.proposal.wbs?.vorgang_nr);
  const conf = chosen ? { label: tr("wp.chosenBadge"), tone: "accent" as Tone } : CONFIDENCE[r.proposal.confidence];
  const reason = clash ? tr("wp.clash") : chosen ? tr("wp.chosenReason") : r.proposal.reason;
  const problem = rowProblem(r);
  const end = new Date(new Date(r.start).getTime() + r.minutes * 60000).toISOString();
  const sources = r.proposal.sources.map((x) => `${tr(SOURCE[x.kind].label)}: ${x.label}`).join("\n");
  return (
    <div className={`wp-row ${r.checked ? "on" : ""} ${clash ? "clash" : ""}`} tabIndex={0} data-id={r.id} aria-selected={r.checked} role="option">
      <input type="checkbox" className="check wp-row-check" checked={r.checked} disabled={problem != null} onChange={onToggle} aria-label={tr("cf.apply")} title={problem ?? undefined} tabIndex={-1} />
      <span className={`wp-src wp-src-${r.proposal.kind}`} title={sources}>
        <Icon size={14} aria-hidden />
        <span className="sr-only">{tr(src.label)}</span>
        {r.proposal.sources.length > 1 && <span className="wp-src-more num">{r.proposal.sources.length}</span>}
      </span>
      <span className="wp-time num">
        {time(r.start)}–{time(end)}
      </span>
      <Input className="wp-dur num" value={r.duration} onChange={(e) => change(r.id, { duration: e.target.value })} aria-label={tr("wp.duration")} title={tr("wp.durationHint")} />
      <div className="wp-text">
        <Input value={r.text} onChange={(e) => change(r.id, { text: e.target.value })} aria-label={tr("wp.description")} />
        <span className="wp-reason" title={r.proposal.reason}>
          {reason}
        </span>
      </div>
      <div className="wp-wbs">
        <NetzplanSelect wbs={wbs} value={r.netzplanId} onChange={(v) => change(r.id, { netzplanId: v, vorgang: "" })} />
        <VorgangSelect wbs={wbs} netzplanId={r.netzplanId} value={r.vorgang} onChange={(v) => change(r.id, { vorgang: v })} />
      </div>
      <span className="wp-conf">
        <Badge tone={conf.tone} title={reason}>
          {conf.label}
        </Badge>
      </span>
    </div>
  );
}

/** Seven small bars: booked, selected and what is missing per day. */
function WeekStrip({ totals, today }: { totals: ReturnType<typeof dayTotals>; today: string }) {
  useT();
  return (
    <div className="wp-strip" role="list" aria-label={tr("wp.week")}>
      {totals.map((t) => {
        const full = Math.max(t.target, t.booked + t.selected, 1);
        const pct = (m: number) => `${Math.min(100, (m / full) * 100)}%`;
        return (
          <div key={t.date} role="listitem" className={`wp-strip-day ${t.date === today ? "today" : ""} ${t.workday ? "" : "off"}`} title={t.target ? tr("wp.stripTarget", { booked: hours(t.booked), selected: hours(t.selected), target: hours(t.target) }) : tr("wp.strip", { booked: hours(t.booked), selected: hours(t.selected) })}>
            <span className="wp-strip-label">
              {weekdayOf(t.date)} <span className="faint">{dayOf(t.date).getDate()}.</span>
            </span>
            <span className="wp-strip-bar" aria-hidden>
              <span className="wp-strip-booked" style={{ width: pct(t.booked) }} />
              <span className="wp-strip-sel" style={{ width: pct(t.selected) }} />
            </span>
            <span className={`wp-strip-num num ${t.gap > 0 ? "gap" : ""}`}>{t.gap > 0 ? `−${fmtMinutes(t.gap)}` : t.booked + t.selected > 0 ? fmtMinutes(t.booked + t.selected) : "–"}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The button that opens the proposal (header of the timesheet). */
export function WeekProposalButton({ onClick }: { onClick: () => void }) {
  useT();
  return (
    <Button icon={WandSparkles} onClick={onClick} className="wp-open">
      {tr("wp.title")}
    </Button>
  );
}
