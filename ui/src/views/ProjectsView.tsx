// Projects → Netzpläne → Vorgänge with budget, remaining effort and schedule
// facts (critical path, float) as tables. Create, edit and delete everything here.

import { useEffect, useState } from "react";
import { Briefcase, MoreHorizontal, Pencil, Play, Plus, Trash2, Target } from "lucide-react";
import { openFocusDialog } from "../components/Focus";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Badge, Button, Dialog, EmptyState, Field, IconButton, Input, Progress, Spinner, useMenu } from "../components/ui";
import { compact, h1, parseGermanNumber } from "../lib/format";
import { LEVEL, useWbs } from "./wbs";
import type { NetzplanOverview, NetzplanTree, ProjectTree, Vorgang } from "../lib/types";
import { useT } from "../lib/i18n";

export { LEVEL };

type DialogState =
  | { kind: "project"; project?: ProjectTree }
  | { kind: "netzplan"; projectId: number; netzplan?: NetzplanTree }
  | { kind: "vorgang"; netzplan: NetzplanTree; vorgang?: Vorgang };

export function ProjectsView() {
  const t = useT();
  const { wbs } = useWbs();
  const entriesVersion = useApp((s) => s.entriesVersion);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  // Budget and schedule of all Netzpläne in one call (not two per Netzplan).
  const [overview, setOverview] = useState<Map<number, NetzplanOverview>>(() => new Map());
  useEffect(() => {
    let alive = true;
    api
      .netzplanOverview()
      .then((list) => alive && setOverview(new Map(list.map((o) => [o.netzplan_id, o]))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [wbs, entriesVersion]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (wbs.length) setLoaded(true);
    const timer = setTimeout(() => setLoaded(true), 400);
    return () => clearTimeout(timer);
  }, [wbs]);

  return (
    <div className="view-scroll">
      <div className="view">
        <header className="view-header">
          <div>
            <h1>{t("ribbon.projects")}</h1>
            <div className="view-sub">{t("proj.sub")}</div>
          </div>
          <div className="view-actions">
            <Button variant="primary" icon={Plus} onClick={() => setDialog({ kind: "project" })}>
              {t("err.kind.project")}
            </Button>
          </div>
        </header>
        {!loaded ? (
          <div className="center-fill">
            <Spinner />
          </div>
        ) : wbs.length === 0 ? (
          <EmptyState icon={Briefcase} title={t("proj.empty")} action={<Button icon={Plus} onClick={() => setDialog({ kind: "project" })}>{t("proj.create")}</Button>}>
            {t("proj.emptyHint")}
          </EmptyState>
        ) : (
          wbs.map((p) => <ProjectCard key={p.id} project={p} overview={overview} open={setDialog} />)
        )}
      </div>
      {dialog && <WbsDialog state={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function ProjectCard({ project, overview, open }: { project: ProjectTree; overview: Map<number, NetzplanOverview>; open: (d: DialogState) => void }) {
  const t = useT();
  const [menu, , openMenuAt] = useMenu();
  const s = useApp.getState;
  return (
    <section className="project">
      <div className="project-head">
        <span className="project-code mono">{project.project_code}</span>
        <h2>{project.name}</h2>
        <span className="grow" />
        <Button size="sm" icon={Plus} variant="ghost" onClick={() => open({ kind: "netzplan", projectId: project.id })}>
          {t("wbs.netzplan")}
        </Button>
        <IconButton
          icon={MoreHorizontal}
          label={t("proj.actions")}
          onClick={(e) =>
            openMenuAt(e, [
              { label: t("att.renameButton"), icon: Pencil, onSelect: () => open({ kind: "project", project }) },
              "separator",
              {
                label: t("proj.delete"),
                icon: Trash2,
                danger: true,
                onSelect: async () => {
                  if (!(await s().confirm({ title: t("proj.deleteAsk"), message: t("proj.deleteText", { code: project.project_code }), confirmLabel: t("common.delete"), danger: true }))) return;
                  try {
                    await api.deleteProject(project.id);
                    s().bumpWbs();
                  } catch (e) {
                    s().error(t("common.deleteFailed"), e);
                  }
                },
              },
            ])
          }
        />
      </div>
      {project.netzplaene.length === 0 && <p className="faint small pad">{t("proj.noNetzplan")}</p>}
      {project.netzplaene.map((n) => (
        <NetzplanBlock key={n.id} netzplan={n} facts={overview.get(n.id)} open={open} />
      ))}
      {menu}
    </section>
  );
}

function NetzplanBlock({ netzplan, facts, open }: { netzplan: NetzplanTree; facts: NetzplanOverview | undefined; open: (d: DialogState) => void }) {
  const t = useT();
  const budget = facts?.budget ?? [];
  const schedule = facts?.schedule ?? null;
  const [menu, , openMenuAt] = useMenu();
  const s = useApp.getState;
  const total = budget.find((b) => b.vorgang_nr == null);
  const level = total ? LEVEL[total.level] : null;

  const startTimer = async (v: Vorgang | null) => {
    try {
      await api.timerStart(netzplan.id, v?.vorgang_nr ?? null, localStorage.getItem("annalo.timer.la") || "DEV", "");
      s().bumpEntries();
      s().toast({ tone: "info", title: t("proj.timerStarted"), detail: `${netzplan.netzplan_nr}${v ? "/" + v.vorgang_nr : ""}` });
    } catch (e) {
      s().error(t("time.timerStartFailed"), e);
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
            <Badge tone={level!.tone} title={t("proj.forecast", { etc: h1(total.etc_hours), eac: h1(total.eac_hours) })}>
              {level!.label}
            </Badge>
          </div>
        )}
        <div className="netzplan-actions">
          <IconButton icon={Play} label={t("proj.timerNetzplan")} onClick={() => startTimer(null)} />
          <IconButton icon={Plus} label={t("proj.addVorgang")} onClick={() => open({ kind: "vorgang", netzplan })} />
          <IconButton
            icon={MoreHorizontal}
            label={t("proj.netzplanActions")}
            onClick={(e) =>
              openMenuAt(e, [
                { label: t("links.editShort"), icon: Pencil, onSelect: () => open({ kind: "netzplan", projectId: netzplan.project_id, netzplan }) },
                "separator",
                {
                  label: t("proj.deleteNetzplan"),
                  icon: Trash2,
                  danger: true,
                  onSelect: async () => {
                    if (!(await s().confirm({ title: t("proj.deleteNetzplanAsk"), message: t("proj.deleteNetzplanText", { nr: netzplan.netzplan_nr }), confirmLabel: t("common.delete"), danger: true }))) return;
                    try {
                      await api.deleteNetzplan(netzplan.id);
                      s().bumpWbs();
                    } catch (e) {
                      s().error(t("common.deleteFailed"), e);
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
                <th>{t("wbs.vorgang")}</th>
                <th>{t("proj.col.schedule")}</th>
                <th className="num">{t("proj.col.plan")}</th>
                <th className="num">{t("calv.booked")}</th>
                <th className="num">{t("proj.col.rest")}</th>
                <th className="budget-col">{t("proj.col.progress")}</th>
                <th>{t("upd.status")}</th>
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
                        <span title={t("proj.scheduleTitle", { faz: node.faz, fez: node.fez, saz: node.saz, sez: node.sez })}>
                          <span className="num">{t("proj.dayRange", { a: node.faz, b: node.fez })}</span>
                          {node.critical ? <span className="crit">{t("proj.critical")}</span> : <span className="faint"> · {t("proj.float", { days: compact(node.gp) })}</span>}
                        </span>
                      ) : (
                        <span className="faint">{t("proj.days", { days: compact(v.duration_days) })}</span>
                      )}
                    </td>
                    <td className="num">{h1(v.planned_hours)}</td>
                    <td className="num">{b ? h1(b.booked_hours) : "–"}</td>
                    <td className="num" title={v.remaining_hours != null ? t("proj.restManual") : t("proj.restAuto")}>
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
                      <IconButton icon={Play} label={t("cmd.startTimer")} size="sm" onClick={() => startTimer(v)} />
                      <IconButton icon={Target} label={t("cmd.focusStart")} size="sm" onClick={() => openFocusDialog({ reference: `${netzplan.netzplan_nr}/${v.vorgang_nr}` })} />
                      <IconButton icon={Pencil} label={t("links.editShort")} size="sm" onClick={() => open({ kind: "vorgang", netzplan, vorgang: v })} />
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
  const t = useT();
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
        errs[k] = t("proj.invalidNumber");
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
      s().error(t("common.saveFailed"), e);
    } finally {
      setBusy(false);
    }
  };

  const title = {
    project: editing ? t("proj.editProject") : t("proj.newProject"),
    netzplan: editing ? t("proj.editNetzplan") : t("proj.newNetzplan"),
    vorgang: editing ? t("proj.editVorgang") : t("proj.newVorgang"),
  }[state.kind];
  const del =
    state.kind === "vorgang" && state.vorgang ? (
      <Button
        variant="danger"
        icon={Trash2}
        onClick={async () => {
          if (!(await s().confirm({ title: t("proj.deleteVorgangAsk"), message: t("proj.deleteVorgangText", { what: `${state.vorgang!.vorgang_nr} ${state.vorgang!.description}` }), confirmLabel: t("common.delete"), danger: true }))) return;
          try {
            await api.deleteVorgang(state.vorgang!.id);
            s().bumpWbs();
            onClose();
          } catch (e) {
            s().error(t("common.deleteFailed"), e);
          }
        }}
      >
        {t("common.delete")}
      </Button>
    ) : null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      width={520}
      footer={
        <>
          {del}
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            {editing ? t("common.save") : t("common.create")}
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
            <Field label={t("proj.projectId")}>
              <Input value={f.code} onChange={set("code")} placeholder="PRJ-2026-X" disabled={!!state.project} data-autofocus />
            </Field>
            <Field label={t("links.name")}>
              <Input value={f.name} onChange={set("name")} placeholder={t("proj.namePlaceholder")} />
            </Field>
          </>
        )}
        {state.kind === "netzplan" && (
          <>
            <Field label={t("proj.netzplanNr")}>
              <Input value={f.nr} onChange={set("nr")} placeholder="NP-8801" disabled={!!state.netzplan} data-autofocus />
            </Field>
            <Field label={t("proj.wbsElement")} hint={t("proj.wbsElementHint")}>
              <Input value={f.wbs} onChange={set("wbs")} placeholder="NP-8801-1020" />
            </Field>
            <Field label={t("time.description")}>
              <Input value={f.desc} onChange={set("desc")} placeholder={t("proj.netzplanPlaceholder")} />
            </Field>
            <Field label={t("proj.plannedHours")} hint={errHint("hours")}>
              <Input value={f.hours} onChange={set("hours")} inputMode="decimal" placeholder="120" aria-invalid={!!bad.hours} />
            </Field>
          </>
        )}
        {state.kind === "vorgang" && (
          <>
            <Field label={t("wbs.vorgang")}>
              <Input value={f.nr} onChange={set("nr")} placeholder="1070" disabled={!!state.vorgang} data-autofocus />
            </Field>
            <Field label={t("time.description")}>
              <Input value={f.desc} onChange={set("desc")} placeholder="Hypercare" />
            </Field>
            <Field label={t("proj.durationDays")} hint={errHint("days")}>
              <Input value={f.days} onChange={set("days")} inputMode="decimal" aria-invalid={!!bad.days} />
            </Field>
            <Field label={t("proj.plannedHours")} hint={errHint("hours")}>
              <Input value={f.hours} onChange={set("hours")} inputMode="decimal" aria-invalid={!!bad.hours} />
            </Field>
            {state.vorgang ? (
              <Field label={t("proj.remaining")} hint={errHint("rest", t("proj.remainingHint"))}>
                <Input value={f.rest} onChange={set("rest")} aria-invalid={!!bad.rest} inputMode="decimal" placeholder={t("proj.automatic")} />
              </Field>
            ) : (
              <Field label={t("proj.after")} hint={t("proj.afterHint")}>
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
