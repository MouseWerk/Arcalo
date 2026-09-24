// Projects → Netzpläne → Vorgänge with budget, remaining effort and schedule
// facts (critical path, float) as tables. Create, edit and delete everything here.

import { useEffect, useState } from "react";
import { Briefcase, MoreHorizontal, Pencil, Play, Plus, Trash2, Target } from "lucide-react";
import { openFocusDialog } from "../components/Focus";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Badge, Button, Dialog, EmptyState, Field, IconButton, Input, Progress, Spinner, useMenu, type Tone } from "../components/ui";
import { compact, h1, parseGermanNumber } from "../lib/format";
import { useWbs } from "./wbs";
import type { AlertLevel, BudgetStatus, NetzplanTree, ProjectTree, Schedule, Vorgang } from "../lib/types";

export const LEVEL: Record<AlertLevel, { label: string; tone: Tone }> = {
  ok: { label: "Im Plan", tone: "success" },
  warning: { label: "Warnung", tone: "warning" },
  critical: { label: "Kritisch", tone: "danger" },
  exceeded: { label: "Überschritten", tone: "danger" },
};

type DialogState =
  | { kind: "project"; project?: ProjectTree }
  | { kind: "netzplan"; projectId: number; netzplan?: NetzplanTree }
  | { kind: "vorgang"; netzplan: NetzplanTree; vorgang?: Vorgang };

export function ProjectsView() {
  const { wbs } = useWbs();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (wbs.length) setLoaded(true);
    const t = setTimeout(() => setLoaded(true), 400);
    return () => clearTimeout(t);
  }, [wbs]);

  return (
    <div className="view-scroll">
      <div className="view">
        <header className="view-header">
          <div>
            <h1>Projekte</h1>
            <div className="view-sub">Projekt, Netzplan (PSP-Element), Vorgang und Leistungsart</div>
          </div>
          <div className="view-actions">
            <Button variant="primary" icon={Plus} onClick={() => setDialog({ kind: "project" })}>
              Projekt
            </Button>
          </div>
        </header>
        {!loaded ? (
          <div className="center-fill">
            <Spinner />
          </div>
        ) : wbs.length === 0 ? (
          <EmptyState icon={Briefcase} title="Noch keine Projekte" action={<Button icon={Plus} onClick={() => setDialog({ kind: "project" })}>Projekt anlegen</Button>}>
            Lege ein Projekt mit Netzplänen und Vorgängen an, um Zeiten darauf zu buchen.
          </EmptyState>
        ) : (
          wbs.map((p) => <ProjectCard key={p.id} project={p} open={setDialog} />)
        )}
      </div>
      {dialog && <WbsDialog state={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function ProjectCard({ project, open }: { project: ProjectTree; open: (d: DialogState) => void }) {
  const [menu, , openMenuAt] = useMenu();
  const s = useApp.getState;
  return (
    <section className="project">
      <div className="project-head">
        <span className="project-code mono">{project.project_code}</span>
        <h2>{project.name}</h2>
        <span className="grow" />
        <Button size="sm" icon={Plus} variant="ghost" onClick={() => open({ kind: "netzplan", projectId: project.id })}>
          Netzplan
        </Button>
        <IconButton
          icon={MoreHorizontal}
          label="Projektaktionen"
          onClick={(e) =>
            openMenuAt(e, [
              { label: "Umbenennen", icon: Pencil, onSelect: () => open({ kind: "project", project }) },
              "separator",
              {
                label: "Projekt löschen",
                icon: Trash2,
                danger: true,
                onSelect: async () => {
                  if (!(await s().confirm({ title: "Projekt löschen?", message: `${project.project_code} mit allen Netzplänen und Vorgängen wird gelöscht. Projekte mit gebuchten Zeiten können nicht gelöscht werden.`, confirmLabel: "Löschen", danger: true }))) return;
                  try {
                    await api.deleteProject(project.id);
                    s().bumpWbs();
                  } catch (e) {
                    s().error("Löschen nicht möglich", e);
                  }
                },
              },
            ])
          }
        />
      </div>
      {project.netzplaene.length === 0 && <p className="faint small pad">Noch keine Netzpläne.</p>}
      {project.netzplaene.map((n) => (
        <NetzplanBlock key={n.id} netzplan={n} open={open} />
      ))}
      {menu}
    </section>
  );
}

function NetzplanBlock({ netzplan, open }: { netzplan: NetzplanTree; open: (d: DialogState) => void }) {
  const entriesVersion = useApp((s) => s.entriesVersion);
  const [budget, setBudget] = useState<BudgetStatus[]>([]);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [menu, , openMenuAt] = useMenu();
  const s = useApp.getState;
  useEffect(() => {
    api.budget(netzplan.id).then(setBudget).catch(() => {});
    api.schedule(netzplan.id).then(setSchedule).catch(() => setSchedule(null));
  }, [netzplan, entriesVersion]);
  const total = budget.find((b) => b.vorgang_nr == null);
  const level = total ? LEVEL[total.level] : null;

  const startTimer = async (v: Vorgang | null) => {
    try {
      await api.timerStart(netzplan.id, v?.vorgang_nr ?? null, localStorage.getItem("annalo.timer.la") || "DEV", "");
      s().bumpEntries();
      s().toast({ tone: "info", title: "Timer gestartet", detail: `${netzplan.netzplan_nr}${v ? "/" + v.vorgang_nr : ""}` });
    } catch (e) {
      s().error("Timer nicht gestartet", e);
    }
  };

  return (
    <div className="netzplan">
      <div className="netzplan-head">
        <div className="netzplan-title">
          <span className="mono strong">{netzplan.netzplan_nr}</span>
          <span>{netzplan.description}</span>
          <span className="faint mono small">{netzplan.wbs_element}</span>
        </div>
        {total && (
          <div className="netzplan-budget">
            <div className="budget-numbers num">
              <span className="strong">{h1(total.booked_hours)}</span>
              <span className="faint"> / {h1(total.planned_hours)} h</span>
            </div>
            <Progress value={total.consumed} tone={level!.tone} marker={total.planned_hours ? total.eac_hours / total.planned_hours : undefined} />
            <Badge tone={level!.tone} title={`Restaufwand ${h1(total.etc_hours)} h, Prognose ${h1(total.eac_hours)} h`}>
              {level!.label}
            </Badge>
          </div>
        )}
        <div className="netzplan-actions">
          <IconButton icon={Play} label="Timer auf Netzplan starten" onClick={() => startTimer(null)} />
          <IconButton icon={Plus} label="Vorgang hinzufügen" onClick={() => open({ kind: "vorgang", netzplan })} />
          <IconButton
            icon={MoreHorizontal}
            label="Netzplanaktionen"
            onClick={(e) =>
              openMenuAt(e, [
                { label: "Bearbeiten", icon: Pencil, onSelect: () => open({ kind: "netzplan", projectId: netzplan.project_id, netzplan }) },
                "separator",
                {
                  label: "Netzplan löschen",
                  icon: Trash2,
                  danger: true,
                  onSelect: async () => {
                    if (!(await s().confirm({ title: "Netzplan löschen?", message: `${netzplan.netzplan_nr} und alle Vorgänge werden gelöscht.`, confirmLabel: "Löschen", danger: true }))) return;
                    try {
                      await api.deleteNetzplan(netzplan.id);
                      s().bumpWbs();
                    } catch (e) {
                      s().error("Löschen nicht möglich", e);
                    }
                  },
                },
              ])
            }
          />
        </div>
      </div>
      {netzplan.vorgaenge.length > 0 && (
        <div className="table-wrap">
          <table className="table vorgaenge">
            <colgroup>
              <col />
              <col style={{ width: 124 }} />
              <col style={{ width: 72 }} />
              <col style={{ width: 80 }} />
              <col style={{ width: 72 }} />
              <col style={{ width: 104 }} />
              <col style={{ width: 100 }} />
              <col style={{ width: 64 }} />
            </colgroup>
            <thead>
              <tr>
                <th>Vorgang</th>
                <th>Termin</th>
                <th className="num">Plan</th>
                <th className="num">Gebucht</th>
                <th className="num">Rest</th>
                <th className="budget-col">Fortschritt</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {netzplan.vorgaenge.map((v) => {
                const b = budget.find((x) => x.vorgang_nr === v.vorgang_nr);
                const node = schedule?.nodes.find((x) => x.vorgang_id === v.id);
                const lv = b ? LEVEL[b.level] : LEVEL.ok;
                return (
                  <tr key={v.id} onDoubleClick={() => open({ kind: "vorgang", netzplan, vorgang: v })}>
                    <td>
                      <span className="mono strong vg-nr">{v.vorgang_nr}</span> {v.description}
                    </td>
                    <td className="small nowrap">
                      {node ? (
                        <span title={`Früheste Lage T${node.faz}–T${node.fez}, späteste T${node.saz}–T${node.sez}`}>
                          <span className="num">T{node.faz}–T{node.fez}</span>
                          {node.critical ? <span className="crit">kritisch</span> : <span className="faint"> · Puffer {compact(node.gp)} T</span>}
                        </span>
                      ) : (
                        <span className="faint">{compact(v.duration_days)} T</span>
                      )}
                    </td>
                    <td className="num">{h1(v.planned_hours)}</td>
                    <td className="num">{b ? h1(b.booked_hours) : "–"}</td>
                    <td className="num" title={v.remaining_hours != null ? "Manuell geschätzt" : "Plan minus gebucht"}>
                      {b ? h1(b.etc_hours) : "–"}
                      {v.remaining_hours != null && <span className="faint">*</span>}
                    </td>
                    <td className="budget-col">
                      <Progress value={b?.consumed ?? 0} tone={lv.tone} />
                    </td>
                    <td>
                      <Badge tone={lv.tone}>{lv.label}</Badge>
                    </td>
                    <td className="row-actions">
                      <IconButton icon={Play} label="Timer starten" size="sm" onClick={() => startTimer(v)} />
                      <IconButton icon={Target} label="Fokussitzung starten" size="sm" onClick={() => openFocusDialog({ reference: `${netzplan.netzplan_nr}/${v.vorgang_nr}` })} />
                      <IconButton icon={Pencil} label="Bearbeiten" size="sm" onClick={() => open({ kind: "vorgang", netzplan, vorgang: v })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {menu}
    </div>
  );
}

function WbsDialog({ state, onClose }: { state: DialogState; onClose: () => void }) {
  const s = useApp.getState;
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState<Record<string, string>>((): Record<string, string> => {
    if (state.kind === "project") return { code: state.project?.project_code ?? "", name: state.project?.name ?? "" };
    if (state.kind === "netzplan")
      return { nr: state.netzplan?.netzplan_nr ?? "", wbs: state.netzplan?.wbs_element ?? "", desc: state.netzplan?.description ?? "", hours: String(state.netzplan?.planned_hours ?? "") };
    const v = state.vorgang;
    return { nr: v?.vorgang_nr ?? "", desc: v?.description ?? "", days: String(v?.duration_days ?? 1), hours: String(v?.planned_hours ?? ""), rest: v?.remaining_hours != null ? String(v.remaining_hours) : "", after: "" };
  });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const [bad, setBad] = useState<Record<string, string>>({});
  const errHint = (k: string, hint?: string) => (bad[k] ? <span className="field-error">{bad[k]}</span> : hint);
  const editing = (state.kind === "project" && state.project) || (state.kind === "netzplan" && state.netzplan) || (state.kind === "vorgang" && state.vorgang);

  const submit = async () => {
    // Validate numbers up front (German notation, "1.200,5").
    const errs: Record<string, string> = {};
    const n = (k: string, emptyZero = false) => {
      const raw = (f[k] ?? "").trim();
      if (!raw && emptyZero) return 0;
      const v = parseGermanNumber(raw);
      if (v == null || v < 0) {
        errs[k] = "Keine gültige Zahl";
        return 0;
      }
      return v;
    };
    let hours = 0, days = 0, rest: number | null = null;
    if (state.kind !== "project") hours = n("hours", true);
    if (state.kind === "vorgang") {
      days = n("days");
      rest = (f.rest ?? "").trim() === "" ? null : n("rest");
    }
    setBad(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      if (state.kind === "project") {
        if (state.project) await api.updateProject(state.project.id, f.name);
        else await api.createProject(f.code, f.name);
      } else if (state.kind === "netzplan") {
        if (state.netzplan) await api.updateNetzplan(state.netzplan.id, f.wbs, f.desc, hours);
        else await api.createNetzplan(state.projectId, f.nr, f.wbs, f.desc, hours);
      } else {
        if (state.vorgang) await api.updateVorgang(state.vorgang.id, f.desc, days, hours, rest);
        else await api.createVorgang(state.netzplan.id, f.nr, f.desc, days, hours, f.after.split(",").map((x) => x.trim()).filter(Boolean));
      }
      s().bumpWbs();
      s().bumpEntries();
      onClose();
    } catch (e) {
      s().error("Speichern fehlgeschlagen", e);
    } finally {
      setBusy(false);
    }
  };

  const title = { project: "Projekt", netzplan: "Netzplan", vorgang: "Vorgang" }[state.kind];
  const del =
    state.kind === "vorgang" && state.vorgang ? (
      <Button
        variant="danger"
        icon={Trash2}
        onClick={async () => {
          if (!(await s().confirm({ title: "Vorgang löschen?", message: `${state.vorgang!.vorgang_nr} ${state.vorgang!.description} wird gelöscht. Gebuchte Zeiten bleiben erhalten.`, confirmLabel: "Löschen", danger: true }))) return;
          try {
            await api.deleteVorgang(state.vorgang!.id);
            s().bumpWbs();
            onClose();
          } catch (e) {
            s().error("Löschen fehlgeschlagen", e);
          }
        }}
      >
        Löschen
      </Button>
    ) : null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${title} ${editing ? "bearbeiten" : "anlegen"}`}
      width={520}
      footer={
        <>
          {del}
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            {editing ? "Speichern" : "Anlegen"}
          </Button>
        </>
      }
    >
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {state.kind === "project" && (
          <>
            <Field label="Projekt-ID">
              <Input value={f.code} onChange={set("code")} placeholder="PRJ-2026-X" disabled={!!state.project} data-autofocus />
            </Field>
            <Field label="Name">
              <Input value={f.name} onChange={set("name")} placeholder="Rollout Kunde X" />
            </Field>
          </>
        )}
        {state.kind === "netzplan" && (
          <>
            <Field label="Netzplan-Nr.">
              <Input value={f.nr} onChange={set("nr")} placeholder="NP-8801" disabled={!!state.netzplan} data-autofocus />
            </Field>
            <Field label="PSP-Element" hint="Leer = Netzplan-Nr.">
              <Input value={f.wbs} onChange={set("wbs")} placeholder="NP-8801-1020" />
            </Field>
            <Field label="Beschreibung">
              <Input value={f.desc} onChange={set("desc")} placeholder="Systemintegration" />
            </Field>
            <Field label="Planstunden" hint={errHint("hours")}>
              <Input value={f.hours} onChange={set("hours")} inputMode="decimal" placeholder="120" aria-invalid={!!bad.hours} />
            </Field>
          </>
        )}
        {state.kind === "vorgang" && (
          <>
            <Field label="Vorgang">
              <Input value={f.nr} onChange={set("nr")} placeholder="1070" disabled={!!state.vorgang} data-autofocus />
            </Field>
            <Field label="Beschreibung">
              <Input value={f.desc} onChange={set("desc")} placeholder="Hypercare" />
            </Field>
            <Field label="Dauer (Tage)" hint={errHint("days")}>
              <Input value={f.days} onChange={set("days")} inputMode="decimal" aria-invalid={!!bad.days} />
            </Field>
            <Field label="Planstunden" hint={errHint("hours")}>
              <Input value={f.hours} onChange={set("hours")} inputMode="decimal" aria-invalid={!!bad.hours} />
            </Field>
            {state.vorgang ? (
              <Field label="Restaufwand (h)" hint={errHint("rest", "Leer lassen, um Plan minus gebucht zu verwenden")}>
                <Input value={f.rest} onChange={set("rest")} aria-invalid={!!bad.rest} inputMode="decimal" placeholder="automatisch" />
              </Field>
            ) : (
              <Field label="Nach Vorgang" hint="Vorgänger, kommagetrennt">
                <Input value={f.after} onChange={set("after")} placeholder="1040, 1050" />
              </Field>
            )}
          </>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
