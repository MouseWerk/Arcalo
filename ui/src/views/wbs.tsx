// Shared WBS pickers for timer, manual entries and the editor dialogs.

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Select, type Tone } from "../components/ui";
import type { AlertLevel, ProjectTree } from "../lib/types";

/** Budget levels as badges show them. */
export const LEVEL: Record<AlertLevel, { label: string; tone: Tone }> = {
  ok: { label: "Im Plan", tone: "success" },
  warning: { label: "Warnung", tone: "warning" },
  critical: { label: "Kritisch", tone: "danger" },
  exceeded: { label: "Überschritten", tone: "danger" },
};

export function useWbs() {
  const version = useApp((s) => s.wbsVersion);
  const [wbs, setWbs] = useState<ProjectTree[]>([]);
  const [las, setLas] = useState<[string, string][]>([]);
  useEffect(() => {
    api.wbs().then(setWbs).catch(() => {});
    api.leistungsarten().then(setLas).catch(() => {});
  }, [version]);
  return { wbs, las };
}

export function NetzplanSelect({ wbs, value, onChange, disabled }: { wbs: ProjectTree[]; value: number | null; onChange: (id: number) => void; disabled?: boolean }) {
  return (
    <Select value={value ?? ""} onChange={(e) => onChange(+e.target.value)} disabled={disabled} aria-label="Netzplan">
      {value == null && <option value="">Netzplan wählen</option>}
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
  const np = wbs.flatMap((p) => p.netzplaene).find((n) => n.id === netzplanId);
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled || !np} aria-label="Vorgang">
      <option value="">Ohne Vorgang</option>
      {np?.vorgaenge.map((v) => (
        <option key={v.id} value={v.vorgang_nr}>
          {v.vorgang_nr} · {v.description}
        </option>
      ))}
    </Select>
  );
}

export function LeistungsartSelect({ las, value, onChange, disabled }: { las: [string, string][]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label="Leistungsart">
      <option value="">Leistungsart</option>
      {las.map(([code, desc]) => (
        <option key={code} value={code} title={desc}>
          {code}
        </option>
      ))}
    </Select>
  );
}
