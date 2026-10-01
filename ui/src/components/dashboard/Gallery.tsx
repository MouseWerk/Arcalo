// „Widget hinzufügen“: every widget with a small preview, grouped and searchable.

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { t } from "../../lib/i18n";
import { GROUP_LABELS, WIDGETS, galleryKinds, type WidgetGroup, type WidgetKind } from "../../lib/dashboard";
import { Dialog, Input } from "../ui";
import { iconOf } from "./registry";
import { viewOf, type GalleryLook as Look } from "./define";
import { workApi } from "../../lib/workwidgets";

const LOOK: Record<WidgetKind, Look> = {
  today: "timeline",
  agenda: "list",
  tasks: "list",
  focus: "ring",
  clock: "clock",
  review: "hbars",
  calendar: "grid",
  week: "bars",
  timer: "list",
  budget: "hbars",
  project: "hbars",
  proposal: "bars",
  recent: "list",
  favorites: "list",
  pinned: "list",
  note: "text",
  embed: "text",
  activity: "list",
  query: "hbars",
  links: "tiles",
  suggestions: "list",
  balance: "bars",
  vacation: "ring",
  deadlines: "list",
  mail_flags: "list",
  next_meeting: "timeline",
  team: "list",
  chart: "bars",
  heatmap: "grid",
  kanban: "tiles",
};

/** A schematic of the widget: neutral shapes in the theme's colors. */
function Preview({ look }: { look: Look }) {
  switch (look) {
    case "bars":
      return (
        <div className="gp gp-bars" aria-hidden>
          {[0.7, 0.9, 0.5, 1, 0.3, 0.15, 0.1].map((h, i) => (
            <span key={i} style={{ height: `${h * 100}%` }} />
          ))}
        </div>
      );
    case "hbars":
      return (
        <div className="gp gp-hbars" aria-hidden>
          {[0.85, 0.6, 0.4].map((w, i) => (
            <span key={i}>
              <i style={{ width: `${w * 100}%` }} />
            </span>
          ))}
        </div>
      );
    case "ring":
      return (
        <div className="gp gp-ring" aria-hidden>
          <span />
          <b />
        </div>
      );
    case "timeline":
      return (
        <div className="gp gp-timeline" aria-hidden>
          <span className="gp-line" />
          <span className="gp-ev" style={{ left: "12%", width: "18%" }} />
          <span className="gp-ev" style={{ left: "46%", width: "26%" }} />
          <span className="gp-now" />
          <span className="gp-l1" />
          <span className="gp-l2" />
        </div>
      );
    case "clock":
      return (
        <div className="gp gp-clock" aria-hidden>
          <b>09:41</b>
        </div>
      );
    case "grid":
      return (
        <div className="gp gp-grid" aria-hidden>
          {Array.from({ length: 21 }, (_, i) => (
            <span key={i} className={i === 9 ? "on" : ""} />
          ))}
        </div>
      );
    case "tiles":
      return (
        <div className="gp gp-tiles" aria-hidden>
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} />
          ))}
        </div>
      );
    case "text":
      return (
        <div className="gp gp-text" aria-hidden>
          <span style={{ width: "60%" }} />
          <span />
          <span style={{ width: "85%" }} />
          <span style={{ width: "40%" }} />
        </div>
      );
    default:
      return (
        <div className="gp gp-list" aria-hidden>
          {[0.8, 0.6, 0.7, 0.5].map((w, i) => (
            <span key={i}>
              <i />
              <b style={{ width: `${w * 100}%` }} />
            </span>
          ))}
        </div>
      );
  }
}

export function Gallery({ onPick, onClose, timeOn = true }: { onPick: (kind: WidgetKind) => void; onClose: () => void; timeOn?: boolean }) {
  const [q, setQ] = useState("");
  const [mailFlags, setMailFlags] = useState(false);
  useEffect(() => {
    workApi.flaggedAvailable().then(setMailFlags, () => {});
  }, []);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = new Map<WidgetGroup, WidgetKind[]>();
    // Time tracking off: no time widgets (the „Zeit“ group disappears with them).
    for (const k of galleryKinds(timeOn, mailFlags)) {
      const d = WIDGETS[k];
      if (needle && !`${t(d.label)} ${t(d.hint)} ${k}`.toLowerCase().includes(needle)) continue;
      out.set(d.group, [...(out.get(d.group) ?? []), k]);
    }
    return out;
  }, [q, timeOn, mailFlags]);
  return (
    <Dialog open onClose={onClose} title={t("dash.gallery.title")} description={t("dash.gallery.desc")} width={760}>
      <div className="dash-gallery">
        <div className="dash-gallery-search">
          <Search size={14} className="faint" aria-hidden />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("dash.gallery.search")}
            aria-label={t("dash.gallery.search")}
            data-autofocus
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const first = [...groups.values()][0]?.[0];
                if (first) onPick(first);
              }
            }}
          />
        </div>
        {groups.size === 0 && <div className="dw-empty">{t("dash.gallery.none")}</div>}
        {[...groups].map(([g, kinds]) => (
          <section key={g} className="dash-gallery-group">
            <h3 className="dw-sub">{t(GROUP_LABELS[g])}</h3>
            <div className="dash-gallery-grid">
              {kinds.map((k) => {
                const Icon = iconOf(k);
                return (
                  <button key={k} type="button" className="dash-gallery-card" data-kind={k} onClick={() => onPick(k)} aria-label={`${t(WIDGETS[k].label)}: ${t(WIDGETS[k].hint)}`}>
                    <Preview look={(Object.hasOwn(LOOK, k) ? LOOK[k] : viewOf(k)?.look) ?? "list"} />
                    <span className="dash-gallery-name">
                      <Icon size={14} aria-hidden />
                      {t(WIDGETS[k].label)}
                    </span>
                    <span className="dash-gallery-hint">{t(WIDGETS[k].hint)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
