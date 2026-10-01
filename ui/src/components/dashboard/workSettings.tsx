// Settings of the work and chart widgets (gear in edit mode), shown by WidgetSettings for
// the kinds it does not know itself.

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { api } from "../../lib/api";
import { useApp } from "../../store/app";
import { t, type TKey } from "../../lib/i18n";
import { useTimeTracking } from "../../lib/timetracking";
import { sourceColor, sourceName } from "../../lib/agenda";
import { parseSchema, type PropDef } from "../../lib/collection";
import { splitFrontmatter } from "../../editor/extensions";
import { bookingGroups, chartQueryOf, type ChartQuery } from "../../lib/workwidgets";
import { Segmented, Select } from "../ui";
import { PagePicker } from "./WidgetSettings";

type Config = Record<string, unknown>;
type RowC = ComponentType<{ label: string; children: ReactNode; hint?: ReactNode }>;
export type WorkSettingsProps = { c: Config; set: (patch: Config) => void; Row: RowC };

const opt = (value: string, label: TKey) => ({ value, label: t(label) });

/** Names of the deadline providers (annalo_core::dashboard::work::DEADLINE_PROVIDERS). */
export const DEADLINE_PROVIDER_LABELS: Record<string, TKey> = { tasks: "work.dl.src.tasks", properties: "work.dl.src.properties" };

function Checks({ all, chosen, onChange, label, color }: { all: [string, string][]; chosen: string[]; onChange: (v: string[]) => void; label: (id: string, name: string) => ReactNode; color?: (id: string) => string }) {
  return (
    <div className="dws-checks">
      {all.map(([id, name]) => (
        <label key={id} className="dws-check">
          <input
            type="checkbox"
            checked={!chosen.length || chosen.includes(id)}
            onChange={(e) => {
              const base = chosen.length ? chosen : all.map((a) => a[0]);
              const next = e.target.checked ? [...base, id] : base.filter((x) => x !== id);
              onChange(next.length === all.length ? [] : next);
            }}
          />
          {color && <span className="dws-swatch" style={{ background: color(id) }} aria-hidden />}
          <span className="ellipsis">{label(id, name)}</span>
        </label>
      ))}
    </div>
  );
}

function DeadlineFields({ c, set, Row }: WorkSettingsProps) {
  const off = Array.isArray(c.off) ? (c.off as string[]) : [];
  return (
    <>
      <Row label={t("work.set.horizon")}>
        <Select aria-label={t("work.set.horizon")} value={String(c.days ?? 14)} onChange={(e) => set({ days: Number(e.target.value) })} options={[7, 14, 30, 60, 90].map((n) => ({ value: String(n), label: t("dash.set.nDays", { n }) }))} />
      </Row>
      <Row label={t("work.set.sources")}>
        <div className="dws-checks">
          {Object.entries(DEADLINE_PROVIDER_LABELS).map(([id, label]) => (
            <label key={id} className="dws-check">
              <input type="checkbox" checked={!off.includes(id)} onChange={(e) => set({ off: e.target.checked ? off.filter((x) => x !== id) : [...off, id] })} />
              <span>{t(label)}</span>
            </label>
          ))}
        </div>
      </Row>
    </>
  );
}

function MeetingFields({ c, set, Row }: WorkSettingsProps) {
  const cal = useApp((st) => st.settings?.settings.calendar);
  const all: [string, string][] = [
    ...(cal?.outlook ? [["outlook", "Outlook"] as [string, string]] : []),
    ...(cal?.outlook ? (cal.outlook_calendars ?? []).filter((x) => x.enabled && x.id !== "outlook").map((x) => [x.id, x.name] as [string, string]) : []),
    ...(cal?.sources ?? []).filter((x) => x.enabled).map((x) => [`ics:${x.id}`, x.name] as [string, string]),
  ];
  const chosen = (c.sources as string[]) ?? [];
  return (
    <Row label={t("dash.set.calendars")} hint={t("dash.set.calendarsHint")}>
      {all.length ? <Checks all={all} chosen={chosen} onChange={(sources) => set({ sources })} label={(id) => sourceName(id, cal)} color={(id) => sourceColor(id, cal)} /> : <span className="faint small">{t("dash.noCalendar")}</span>}
    </Row>
  );
}

const SHARED_KINDS = new Set(["mailbox", "shared", "room", "group"]);

function TeamFields({ c, set, Row }: WorkSettingsProps) {
  const cal = useApp((st) => st.settings?.settings.calendar);
  const all: [string, string][] = (cal?.outlook_calendars ?? []).filter((x) => x.enabled && SHARED_KINDS.has(x.kind)).map((x) => [x.id, x.owner || x.name]);
  const chosen = (c.sources as string[]) ?? [];
  return (
    <Row label={t("work.set.people")} hint={t("work.set.peopleHint")}>
      {all.length ? (
        <Checks all={all} chosen={chosen} onChange={(sources) => set({ sources })} label={(id, name) => `${name}${cal?.outlook_calendars?.find((x) => x.id === id)?.free_busy ? ` (${t("work.set.freeBusy")})` : ""}`} color={(id) => sourceColor(id, cal)} />
      ) : (
        <span className="faint small">{t("work.team.noCalendars")}</span>
      )}
    </Row>
  );
}

/** The properties of the page `id`'s schema (its children's table). */
function useSchema(id: number | null): PropDef[] | null {
  const [defs, setDefs] = useState<PropDef[] | null>(null);
  useEffect(() => {
    if (id == null) return setDefs(null);
    let alive = true;
    api.page(id).then(
      (doc) => alive && setDefs(parseSchema(splitFrontmatter(doc.content).frontmatter)),
      () => alive && setDefs(null),
    );
    return () => {
      alive = false;
    };
  }, [id]);
  return defs;
}

const GROUP_LABEL: Record<string, TKey> = { netzplan: "work.set.byNetzplan", vorgang: "work.set.byVorgang", activity: "work.set.byActivity", week: "work.set.byWeek", month: "work.set.byMonth" };

function ChartFields({ c, set, Row }: WorkSettingsProps) {
  const timeOn = useTimeTracking();
  const q = chartQueryOf(c);
  const setQ = (patch: Partial<ChartQuery>) => set({ chart: { ...q, ...patch } });
  const defs = useSchema(q.source === "pages" ? q.page : null);
  const groupable = (defs ?? []).filter((d) => d.kind !== "number" && d.kind !== "link");
  const numbers = (defs ?? []).filter((d) => d.kind === "number");
  return (
    <>
      <Row label={t("work.set.type")}>
        <Segmented label={t("work.set.type")} value={c.type === "line" || c.type === "pie" ? (c.type as string) : "bar"} options={[opt("bar", "work.set.bar"), opt("line", "work.set.line"), opt("pie", "work.set.pie")]} onChange={(v) => set({ type: v })} />
      </Row>
      {timeOn && (
        <Row label={t("work.set.source")}>
          <Segmented label={t("work.set.source")} value={q.source} options={[opt("pages", "work.set.srcPages"), opt("bookings", "work.set.srcBookings")]} onChange={(v) => setQ({ source: v as ChartQuery["source"], group: v === "bookings" ? "netzplan" : "status" })} />
        </Row>
      )}
      {q.source === "pages" || !timeOn ? (
        <>
          <Row label={t("work.set.page")} hint={t("work.set.pageHint")}>
            <PagePicker value={q.page} onChange={(id) => setQ({ page: id, source: "pages" })} label={t("work.set.page")} />
          </Row>
          {q.page != null && (
            <>
              <Row label={t("work.set.groupBy")}>
                {groupable.length ? (
                  <Select aria-label={t("work.set.groupBy")} value={groupable.some((d) => d.key === q.group) ? q.group : ""} onChange={(e) => setQ({ group: e.target.value })} options={[{ value: "", label: "–" }, ...groupable.map((d) => ({ value: d.key, label: d.key }))]} />
                ) : (
                  <span className="faint small">{t("work.set.noProps")}</span>
                )}
              </Row>
              <Row label={t("work.set.value")}>
                <div className="dws-inline">
                  <Segmented label={t("work.set.value")} value={q.value} options={[opt("count", "work.set.count"), opt("sum", "work.set.sum")]} onChange={(v) => setQ({ value: v as ChartQuery["value"] })} />
                  {q.value === "sum" && (
                    <Select aria-label={t("work.set.field")} value={q.field} onChange={(e) => setQ({ field: e.target.value })} options={[{ value: "", label: "–" }, ...numbers.map((d) => ({ value: d.key, label: d.key }))]} />
                  )}
                </div>
              </Row>
            </>
          )}
        </>
      ) : (
        <>
          <Row label={t("work.set.groupBy")}>
            <Select aria-label={t("work.set.groupBy")} value={q.group} onChange={(e) => setQ({ group: e.target.value })} options={bookingGroups().map((g) => opt(g, GROUP_LABEL[g]))} />
          </Row>
          <Row label={t("work.set.range")}>
            <Select aria-label={t("work.set.range")} value={String(q.weeks)} onChange={(e) => setQ({ weeks: Number(e.target.value) })} options={[4, 8, 12, 26, 52].map((n) => ({ value: String(n), label: t("work.set.weeks", { n }) }))} />
          </Row>
        </>
      )}
    </>
  );
}

function HeatmapFields({ c, set, Row }: WorkSettingsProps) {
  const timeOn = useTimeTracking();
  if (!timeOn) return <div className="faint small">{t("work.set.heatNotes")}</div>;
  return (
    <Row label={t("dash.set.show")}>
      <Segmented label={t("dash.set.show")} value={c.mode === "hours" ? "hours" : "notes"} options={[opt("notes", "work.set.heatPages"), opt("hours", "work.set.heatHours")]} onChange={(v) => set({ mode: v })} />
    </Row>
  );
}

function KanbanFields({ c, set, Row }: WorkSettingsProps) {
  return (
    <Row label={t("work.set.page")} hint={t("work.set.kanbanHint")}>
      <PagePicker value={typeof c.page === "number" ? c.page : null} onChange={(id) => set({ page: id })} label={t("work.set.page")} />
    </Row>
  );
}

export const WORK_SETTINGS: Record<string, ComponentType<WorkSettingsProps> | undefined> = {
  deadlines: DeadlineFields,
  next_meeting: MeetingFields,
  team: TeamFields,
  chart: ChartFields,
  heatmap: HeatmapFields,
  kanban: KanbanFields,
};
