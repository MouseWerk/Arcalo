// The settings of one widget (gear in edit mode): its title and what it shows. The „Abfrage“
// widget gets the query builder with a live preview.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { api } from "../../lib/api";
import { useApp } from "../../store/app";
import { isoDay } from "../../lib/format";
import { currentLang, t, type TKey } from "../../lib/i18n";
import { configOf, isKind, titleOf, TODAY_BLOCKS, TODAY_TIME_BLOCKS, WIDGETS, type TodayBlock } from "../../lib/dashboard";
import { timeTrackingEnabled } from "../../lib/timetracking";
import { applyLine, canonicalField, DISPLAYS, emptyQuery, fieldName, FIELDS, GROUPS, normalizeQuery, parseQueryLine, queryLine, SOURCES, type QueryDisplay, type QuerySource, type WidgetQuery } from "../../lib/dashquery";
import { normalizeLinks, isGroup } from "../../lib/quicklinks";
import { sourceColor, sourceName } from "../../lib/agenda";
import { useHiddenCalendars } from "../../lib/calvisibility";
import type { GridWidget } from "../../lib/types";
import type { BudgetRow, QueryResult } from "../../lib/dashtypes";
import { Button, Dialog, IconButton, Input, Segmented, Select, Switch } from "../ui";
import { PageIcon } from "../icons";
import { NetzplanSelect, useWbs } from "../../views/wbs";
import { QueryView } from "./tools";
import { viewOf } from "./define";
import { cityOf, timeZones } from "../../lib/worldclock";
import { WORK_SETTINGS } from "./workSettings";
import { JiraWidgetFields } from "./jira";

type Config = Record<string, unknown>;

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="dws-row">
      <div className="dws-label">
        <span>{label}</span>
        {hint && <span className="faint small">{hint}</span>}
      </div>
      <div className="dws-control">{children}</div>
    </div>
  );
}

/** Picks a page by typing part of its title. */
export function PagePicker({ value, onChange, label, exclude = [] }: { value: number | null; onChange: (id: number | null) => void; label: string; exclude?: number[] }) {
  const pages = useApp((st) => st.pages);
  const [q, setQ] = useState("");
  const current = value != null ? pages.get(value) : undefined;
  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const out = [];
    for (const p of pages.values()) {
      if (p.deleted_at || exclude.includes(p.id)) continue;
      if (p.title.toLowerCase().includes(needle)) out.push(p);
      if (out.length >= 8) break;
    }
    return out.sort((a, b) => Number(!a.title.toLowerCase().startsWith(needle)) - Number(!b.title.toLowerCase().startsWith(needle)));
  }, [q, pages, exclude]);
  return (
    <div className="dws-picker">
      {current && (
        <div className="dws-chosen">
          <PageIcon name={current.icon} size={14} />
          <span className="ellipsis grow">{current.title}</span>
          <IconButton icon={X} size="sm" label={t("dash.set.clearPage")} onClick={() => onChange(null)} />
        </div>
      )}
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("dash.set.searchPage")} aria-label={label} />
      {hits.length > 0 && (
        <ul className="dws-hits" role="listbox" aria-label={label}>
          {hits.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                role="option"
                aria-selected={p.id === value}
                className="dw-row"
                onClick={() => {
                  onChange(p.id);
                  setQ("");
                }}
              >
                <PageIcon name={p.icon} size={14} />
                <span className="ellipsis">{p.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const opt = (value: string, label: TKey) => ({ value, label: t(label) });

function QueryBuilder({ c, set }: { c: Config; set: (patch: Config) => void }) {
  const q = normalizeQuery(c.query);
  const display = (c.display as QueryDisplay) ?? "list";
  const [line, setLine] = useState(() => queryLine(q, currentLang()));
  const parsed = parseQueryLine(line);
  const setQuery = (next: WidgetQuery) => set({ query: next });
  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(q);
  useEffect(() => {
    let alive = true;
    const id = window.setTimeout(() => {
      api.dashboardData(isoDay(new Date()), [{ key: "q", part: { kind: "query", query: q } }]).then(
        (r) => {
          if (!alive) return;
          const v = r.parts.q as QueryResult & { error?: string };
          if (v?.error) (setError(v.error), setPreview(null));
          else (setError(null), setPreview(v));
        },
        (e) => alive && setError(String(e)),
      );
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const groups = GROUPS[q.source];
  return (
    <>
      <Row label={t("dash.q.source")}>
        <Segmented
          label={t("dash.q.source")}
          value={q.source}
          options={SOURCES.filter((x) => x.value !== "entries" || q.source === "entries" || timeTrackingEnabled()).map((x) => ({ value: x.value, label: t(x.label) }))}
          onChange={(v: QuerySource) => {
            const base = emptyQuery(v);
            const next = applyLine({ ...base, limit: q.limit }, line);
            setQuery({ ...next, group: "" });
          }}
        />
      </Row>
      <Row label={t("dash.q.filter")}>
        <Input
          value={line}
          className="mono dws-query"
          aria-label={t("dash.q.filter")}
          placeholder={t(`dash.q.ph.${q.source}` as TKey)}
          onChange={(e) => {
            setLine(e.target.value);
            setQuery(applyLine(q, e.target.value));
          }}
        />
        <div className="dws-chips" aria-live="polite">
          {parsed.tag && <span className="dws-chip">#{parsed.tag}</span>}
          {parsed.filters.map((f, i) => (
            <span key={i} className="dws-chip">
              <b>{f.field}</b> {f.op} {f.value && <span className="mono">{f.value}</span>}
            </span>
          ))}
          {parsed.text && <span className="dws-chip text">„{parsed.text}“</span>}
          {parsed.problems.map((p) => (
            <span key={p} className="dws-chip bad" title={t("dash.q.problem")}>
              {p}
            </span>
          ))}
        </div>
        <div className="faint small dws-help">{t("dash.q.fields", { fields: FIELDS[q.source].map((f) => fieldName(f, currentLang())).join(", ") })}</div>
      </Row>
      <Row label={t("dash.q.display")}>
        <Segmented label={t("dash.q.display")} value={display} options={DISPLAYS.map((x) => ({ value: x.value, label: t(x.label) }))} onChange={(v: QueryDisplay) => set({ display: v })} />
      </Row>
      {display === "bar" && (
        <Row label={t("dash.q.group")}>
          {q.source === "pages" ? (
            <Input value={fieldName(q.group, currentLang())} aria-label={t("dash.q.group")} placeholder={t("dash.q.groupPh")} onChange={(e) => setQuery({ ...q, group: e.target.value.trim() ? canonicalField(e.target.value.trim()) : "" })} list="dws-groups" />
          ) : (
            <Select aria-label={t("dash.q.group")} value={q.group} onChange={(e) => setQuery({ ...q, group: e.target.value })} options={[{ value: "", label: t("dash.q.groupNone") }, ...groups.map((g) => ({ value: g, label: fieldName(g, currentLang()) }))]} />
          )}
          <datalist id="dws-groups">
            {groups.map((g) => (
              <option key={g} value={fieldName(g, currentLang())} />
            ))}
          </datalist>
        </Row>
      )}
      {display === "table" && q.source === "pages" && (
        <Row label={t("dash.q.columns")} hint={t("dash.q.columnsHint")}>
          <Input value={q.columns.join(", ")} aria-label={t("dash.q.columns")} placeholder={t("dash.q.columnsPh")} onChange={(e) => setQuery({ ...q, columns: e.target.value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 6) })} />
        </Row>
      )}
      <Row label={t("dash.q.limit")}>
        <Select aria-label={t("dash.q.limit")} value={String(q.limit)} onChange={(e) => setQuery({ ...q, limit: Number(e.target.value) })} options={[5, 10, 20, 50].map((n) => ({ value: String(n), label: String(n) }))} />
      </Row>
      <div className="dws-preview" aria-label={t("dash.q.preview")}>
        <div className="dws-preview-head">
          <span className="dw-sub">{t("dash.q.preview")}</span>
          {preview && <span className="faint small num">{t("dash.q.hits", { n: preview.total })}</span>}
        </div>
        <div className="dws-preview-body dw">{error ? <div className="dw-error">{error}</div> : preview ? <QueryView q={q} display={display} res={preview} title={t("dash.w.query")} /> : null}</div>
      </div>
    </>
  );
}

function BudgetRefs({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [rows, setRows] = useState<BudgetRow[] | null>(null);
  useEffect(() => {
    api
      .dashboardData(isoDay(new Date()), [{ key: "b", part: { kind: "budgets" } }])
      .then((r) => setRows(((r.parts.b as { budgets?: BudgetRow[] })?.budgets ?? []) as BudgetRow[]))
      .catch(() => setRows([]));
  }, []);
  if (!rows) return null;
  return (
    <div className="dws-checks">
      {rows.map((b) => (
        <label key={b.label} className="dws-check">
          <input type="checkbox" checked={value.includes(b.label)} onChange={(e) => onChange(e.target.checked ? [...value, b.label] : value.filter((x) => x !== b.label))} />
          <span className="mono">{b.label}</span>
          <span className="faint ellipsis">{b.title}</span>
        </label>
      ))}
    </div>
  );
}

function KindFields({ w, c, set }: { w: GridWidget; c: Config; set: (patch: Config) => void }) {
  const settings = useApp((st) => st.settings?.settings);
  const hidden = useHiddenCalendars();
  const { wbs } = useWbs();
  const toggle = (key: string, label: TKey, invert = false) => (
    <Row label={t(label)}>
      <Switch label={t(label)} checked={invert ? c[key] === true : c[key] !== false} onChange={(v) => set({ [key]: v })} />
    </Row>
  );
  switch (w.kind) {
    case "today": {
      const blocks = (c.blocks ?? {}) as Partial<Record<TodayBlock, boolean>>;
      return (
        <Row label={t("dash.set.blocks")}>
          <div className="dws-checks">
            {TODAY_BLOCKS.filter((b) => timeTrackingEnabled() || !TODAY_TIME_BLOCKS.has(b)).map((b) => (
              <label key={b} className="dws-check">
                <input type="checkbox" checked={blocks[b] !== false} onChange={(e) => set({ blocks: { ...blocks, [b]: e.target.checked } })} />
                <span>{t(`dash.block.${b}` as TKey)}</span>
              </label>
            ))}
          </div>
        </Row>
      );
    }
    case "agenda": {
      const cal = settings?.calendar;
      // Outlook (its default calendar and the other selected ones) and the ICS calendars.
      const all = [
        ...(cal?.outlook ? ["outlook"] : []),
        ...(cal?.outlook ? (cal.outlook_calendars ?? []).filter((x) => x.enabled && x.id !== "outlook").map((x) => x.id) : []),
        ...(cal?.sources ?? []).filter((x) => x.enabled).map((x) => `ics:${x.id}`),
      ];
      const chosen = (c.sources as string[]) ?? [];
      return (
        <>
          <Row label={t("dash.set.days")}>
            <Select aria-label={t("dash.set.days")} value={String(c.days ?? 1)} onChange={(e) => set({ days: Number(e.target.value) })} options={[1, 2, 3, 5, 7, 14].map((n) => ({ value: String(n), label: n === 1 ? t("dash.set.todayOnly") : t("dash.set.nDays", { n }) }))} />
          </Row>
          <Row label={t("dash.set.calendars")} hint={t("dash.set.calendarsHint")}>
            {all.length ? (
              <div className="dws-checks">
                {all.map((id) => (
                  <label key={id} className="dws-check">
                    <input type="checkbox" checked={!chosen.length || chosen.includes(id)} onChange={(e) => {
                      const base = chosen.length ? chosen : all;
                      const next = e.target.checked ? [...base, id] : base.filter((x) => x !== id);
                      set({ sources: next.length === all.length ? [] : next });
                    }} />
                    <span className="dws-swatch" style={{ background: sourceColor(id, cal) }} aria-hidden />
                    <span className="ellipsis">{sourceName(id, cal)}</span>
                    {hidden.has(id) && <span className="faint small">{t("dash.set.hiddenInCalendar")}</span>}
                  </label>
                ))}
              </div>
            ) : (
              <span className="faint small">{t("dash.noCalendar")}</span>
            )}
          </Row>
        </>
      );
    }
    case "tasks":
      return (
        <>
          <Row label={t("dash.set.due")}>
            <Select aria-label={t("dash.set.due")} value={String(c.due ?? "any")} onChange={(e) => set({ due: e.target.value })} options={[opt("any", "dash.due.any"), opt("overdue", "dash.due.overdue"), opt("today", "dash.due.today"), opt("week", "dash.due.week"), opt("dated", "dash.due.dated"), opt("none", "dash.due.none")]} />
          </Row>
          <Row label={t("dash.set.priority")}>
            <Select aria-label={t("dash.set.priority")} value={String(c.priority ?? 0)} onChange={(e) => set({ priority: Number(e.target.value) })} options={[opt("0", "dash.prio.all"), opt("1", "dash.prio.medium"), opt("2", "dash.prio.high")]} />
          </Row>
          <Row label={t("dash.set.tag")}>
            <Input value={String(c.tag ?? "")} aria-label={t("dash.set.tag")} placeholder="#kunde" onChange={(e) => set({ tag: e.target.value })} />
          </Row>
          <Row label={t("dash.set.page")} hint={t("dash.set.pageHint")}>
            <PagePicker value={typeof c.page === "number" ? c.page : null} onChange={(id) => set({ page: id })} label={t("dash.set.page")} />
          </Row>
          {toggle("add", "dash.set.addField")}
        </>
      );
    case "week":
      return (
        <Row label={t("dash.set.show")}>
          <Segmented label={t("dash.set.show")} value={c.mode === "wbs" ? "wbs" : "day"} options={[opt("day", "dash.set.perDay"), opt("wbs", "dash.set.perWbs")]} onChange={(v) => set({ mode: v })} />
        </Row>
      );
    case "budget":
      return (
        <>
          <Row label={t("dash.set.show")}>
            <Segmented label={t("dash.set.show")} value={c.mode === "selected" ? "selected" : "worst"} options={[opt("worst", "dash.set.worst"), opt("selected", "dash.set.selected")]} onChange={(v) => set({ mode: v })} />
          </Row>
          {c.mode === "selected" ? (
            <Row label={t("dash.set.budgets")}>
              <BudgetRefs value={(c.refs as string[]) ?? []} onChange={(refs) => set({ refs })} />
            </Row>
          ) : (
            <Row label={t("dash.set.count")}>
              <Select aria-label={t("dash.set.count")} value={String(c.count ?? 4)} onChange={(e) => set({ count: Number(e.target.value) })} options={[1, 2, 3, 4, 5, 6, 8, 10].map((n) => ({ value: String(n), label: String(n) }))} />
            </Row>
          )}
          {toggle("forecast", "dash.set.forecast")}
        </>
      );
    case "project":
      return (
        <Row label={t("dash.set.netzplan")} hint={t("dash.set.netzplanHint")}>
          <NetzplanSelect wbs={wbs} value={typeof c.netzplan === "number" ? c.netzplan : null} onChange={(id) => set({ netzplan: id })} />
          {typeof c.netzplan === "number" && (
            <button type="button" className="dw-link" onClick={() => set({ netzplan: null })}>
              {t("dash.set.netzplanAuto")}
            </button>
          )}
        </Row>
      );
    case "recent":
    case "activity":
      return (
        <Row label={t("dash.set.count")}>
          <Select aria-label={t("dash.set.count")} value={String(c.limit ?? 8)} onChange={(e) => set({ limit: Number(e.target.value) })} options={[4, 6, 8, 10, 15, 20].map((n) => ({ value: String(n), label: String(n) }))} />
        </Row>
      );
    case "pinned": {
      const ids = (c.pages as number[]) ?? [];
      return (
        <Row label={t("dash.set.pages")}>
          <PinnedPages ids={ids} onChange={(pages) => set({ pages })} />
        </Row>
      );
    }
    case "note":
      return (
        <>
          <Row label={t("dash.set.noteMode")}>
            <Segmented label={t("dash.set.noteMode")} value={c.mode === "page" ? "page" : "text"} options={[opt("text", "dash.set.noteText"), opt("page", "dash.set.notePage")]} onChange={(v) => set({ mode: v })} />
          </Row>
          {c.mode === "page" && (
            <Row label={t("dash.set.page")}>
              <PagePicker value={typeof c.page === "number" ? c.page : null} onChange={(id) => set({ page: id })} label={t("dash.set.page")} />
            </Row>
          )}
        </>
      );
    case "embed":
      return (
        <Row label={t("dash.set.page")}>
          <PagePicker value={typeof c.page === "number" ? c.page : null} onChange={(id) => set({ page: id })} label={t("dash.set.page")} />
        </Row>
      );
    case "query":
      return <QueryBuilder c={c} set={set} />;
    case "focus":
      return toggle("week", "dash.set.focusWeek");
    case "clock":
      return (
        <>
          {toggle("seconds", "dash.set.seconds", true)}
          {toggle("week", "dash.set.kw")}
          <Row label={t("dash.set.hours")}>
            <Segmented label={t("dash.set.hours")} value={c.hour12 === true ? "12" : c.hour12 === false ? "24" : "auto"} options={[opt("auto", "dash.set.hoursAuto"), opt("24", "dash.set.hours24"), opt("12", "dash.set.hours12")]} onChange={(v) => set({ hour12: v === "auto" ? null : v === "12" })} />
          </Row>
          <Row label={t("dash.set.zones")} hint={t("dash.set.zonesHint")}>
            <ZoneList zones={Array.isArray(c.zones) ? (c.zones as string[]) : []} onChange={(zones) => set({ zones })} />
          </Row>
        </>
      );
    case "review":
      return toggle("workday", "dash.set.lastWorkday");
    case "links": {
      const links = normalizeLinks(settings?.quick_links);
      return (
        <Row label={t("dash.set.links")}>
          <Select aria-label={t("dash.set.links")} value={String(c.group ?? -1)} onChange={(e) => set({ group: Number(e.target.value) })} options={[{ value: "-1", label: t("dash.set.linksRibbon") }, ...links.flatMap((l, i) => (isGroup(l) ? [{ value: String(i), label: l.name }] : []))]} />
        </Row>
      );
    }
    case "suggestions":
      return (
        <Row label={t("dash.set.count")}>
          <Select aria-label={t("dash.set.count")} value={String(c.count ?? 5)} onChange={(e) => set({ count: Number(e.target.value) })} options={[3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))} />
        </Row>
      );
    case "jira":
    case "jira_query":
    case "jira_sprint":
      return <JiraWidgetFields kind={w.kind} c={c} set={set} />;
    default: {
      // Registered widgets bring their own fields (define.ts); the work widgets theirs.
      const Own = viewOf(w.kind)?.settings;
      if (Own) return <Own widget={w} config={c} set={set} />;
      const Extra = WORK_SETTINGS[w.kind];
      return Extra ? <Extra c={c} set={set} Row={Row} /> : <div className="faint small">{t("dash.set.nothing")}</div>;
    }
  }
}

/** The extra time zones of the clock: listed with their city, added by typing a zone or city. */
function ZoneList({ zones, onChange }: { zones: string[]; onChange: (zones: string[]) => void }) {
  const [q, setQ] = useState("");
  const all = useMemo(() => timeZones(), []);
  const add = (v: string) => {
    const hit = all.find((z) => z.toLowerCase() === v.trim().toLowerCase()) ?? all.find((z) => cityOf(z).toLowerCase() === v.trim().toLowerCase());
    if (hit && !zones.includes(hit) && zones.length < 6) onChange([...zones, hit]);
    setQ("");
  };
  return (
    <div className="dws-pinned">
      {zones.map((z) => (
        <div key={z} className="dws-chosen">
          <span className="ellipsis grow">{cityOf(z)}</span>
          <span className="faint small mono">{z}</span>
          <IconButton icon={X} size="sm" label={t("dash.set.zoneRemove", { zone: cityOf(z) })} onClick={() => onChange(zones.filter((x) => x !== z))} />
        </div>
      ))}
      {zones.length < 6 && (
        <>
          <Input
            value={q}
            list="dws-zones"
            aria-label={t("dash.set.zoneAdd")}
            placeholder={t("dash.set.zonePh")}
            onChange={(e) => {
              setQ(e.target.value);
              // Picking from the list adds at once.
              if (all.includes(e.target.value)) add(e.target.value);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add(q))}
          />
          <datalist id="dws-zones">
            {all.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </>
      )}
    </div>
  );
}

function PinnedPages({ ids, onChange }: { ids: number[]; onChange: (ids: number[]) => void }) {
  const pages = useApp((st) => st.pages);
  return (
    <div className="dws-pinned">
      {ids.map((id) => {
        const p = pages.get(id);
        return (
          <div key={id} className="dws-chosen">
            <PageIcon name={p?.icon} size={14} />
            <span className="ellipsis grow">{p?.title ?? `#${id}`}</span>
            <IconButton icon={X} size="sm" label={t("dash.set.unpin", { title: p?.title ?? "" })} onClick={() => onChange(ids.filter((x) => x !== id))} />
          </div>
        );
      })}
      {ids.length < 20 && <PagePicker value={null} onChange={(id) => id != null && onChange([...ids, id])} label={t("dash.set.addPage")} exclude={ids} />}
    </div>
  );
}

export function WidgetSettings({ widget, onClose, onApply }: { widget: GridWidget; onClose: () => void; onApply: (config: Config, title: string) => void }) {
  const [c, setC] = useState<Config>(() => configOf(widget));
  const [title, setTitle] = useState(widget.title ?? "");
  const wide = widget.kind === "query" || widget.kind === "chart";
  const hint = isKind(widget.kind) ? t(WIDGETS[widget.kind].hint) : "";
  return (
    <Dialog
      open
      onClose={onClose}
      width={wide ? 640 : 480}
      title={t("dash.set.title", { name: titleOf(widget) })}
      description={hint}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("dash.cancel")}
          </Button>
          <Button variant="primary" onClick={() => onApply(c, title.trim())}>
            {t("dash.apply")}
          </Button>
        </>
      }
    >
      <div className="dws">
        <Row label={t("dash.set.name")}>
          <Input value={title} aria-label={t("dash.set.name")} placeholder={isKind(widget.kind) ? t(WIDGETS[widget.kind].label) : ""} onChange={(e) => setTitle(e.target.value)} maxLength={60} data-autofocus />
        </Row>
        <KindFields w={widget} c={c} set={(patch) => setC((prev) => ({ ...prev, ...patch }))} />
      </div>
    </Dialog>
  );
}
