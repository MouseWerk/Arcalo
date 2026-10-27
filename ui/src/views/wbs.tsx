// Shared WBS pickers for timer, manual entries and the editor dialogs.

import { useEffect, useState } from "react";
import { useApp } from "../store/app";
import { Select, type Tone } from "../components/ui";
import type { AlertLevel, ProjectTree } from "../lib/types";
import { useT, withLabel } from "../lib/i18n";
import { leistungsarten, wbsTree } from "../lib/wbsCache";

/** Budget levels as badges show them. */
export const LEVEL: Record<AlertLevel, { readonly label: string; tone: Tone }> = {
  ok: withLabel({ tone: "success" as Tone }, "wbs.level.ok"),
  warning: withLabel({ tone: "warning" as Tone }, "wbs.level.warning"),
  critical: withLabel({ tone: "danger" as Tone }, "wbs.level.critical"),
  exceeded: withLabel({ tone: "danger" as Tone }, "wbs.level.exceeded"),
};

export function useWbs() {
  const version = useApp((s) => s.wbsVersion);
  const [wbs, setWbs] = useState<ProjectTree[]>([]);
  const [las, setLas] = useState<[string, string][]>([]);
  useEffect(() => {
    let alive = true;
    wbsTree().then((w) => alive && setWbs(w), () => {});
    leistungsarten().then((l) => alive && setLas(l), () => {});
    return () => {
      alive = false;
    };
  }, [version]);
  return { wbs, las };
}

export function NetzplanSelect({ wbs, value, onChange, disabled }: { wbs: ProjectTree[]; value: number | null; onChange: (id: number) => void; disabled?: boolean }) {
  const t = useT();
  return (
    <Select value={value ?? ""} onChange={(e) => onChange(+e.target.value)} disabled={disabled} aria-label={t("wbs.netzplan")}>
      {value == null && <option value="">{t("week.problem.netzplan")}</option>}
      {wbs.map((p) => (
        <optgroup key={p.id} label={`${p.project_code} · ${p.name}`}>
          {p.netzplaene.map((n) => (
            <option key={n.id} value={n.id}>
              {n.netzplan_nr} · {n.description || n.wbs_element}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

export function VorgangSelect({ wbs, netzplanId, value, onChange, disabled }: { wbs: ProjectTree[]; netzplanId: number | null; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const t = useT();
  const np = wbs.flatMap((p) => p.netzplaene).find((n) => n.id === netzplanId);
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled || !np} aria-label={t("wbs.vorgang")}>
      <option value="">{t("wbs.noVorgang")}</option>
      {np?.vorgaenge.map((v) => (
        <option key={v.id} value={v.vorgang_nr}>
          {v.vorgang_nr} · {v.description}
        </option>
      ))}
    </Select>
  );
}

export function LeistungsartSelect({ las, value, onChange, disabled }: { las: [string, string][]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const t = useT();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label={t("wbs.leistungsart")}>
      <option value="">{t("wbs.leistungsart")}</option>
      {las.map(([code, desc]) => (
        <option key={code} value={code} title={desc}>
          {code}
        </option>
      ))}
    </Select>
  );
}
